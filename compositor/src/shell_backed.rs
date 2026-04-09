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

#[derive(Debug, Clone)]
pub(crate) struct ShellBackedWindowEntry {
    pub(crate) client_global: Rectangle<i32, Logical>,
    pub(crate) minimized: bool,
    pub(crate) maximized: bool,
    pub(crate) float_restore: Option<Rectangle<i32, Logical>>,
    pub(crate) title: String,
    pub(crate) app_id: String,
    pub(crate) output_name: String,
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
    pub(crate) fn shell_backed_outer_global_rect(
        &self,
        e: &ShellBackedWindowEntry,
    ) -> Rectangle<i32, Logical> {
        let th = self.shell_chrome_titlebar_h.max(0);
        let bd = self.shell_chrome_border_w.max(0);
        let inset = if e.maximized { 0 } else { bd };
        let c = &e.client_global;
        let ox = c.loc.x.saturating_sub(inset);
        let oy = c.loc.y.saturating_sub(th + inset);
        let ow = c.size.w + inset * 2;
        let oh = c.size.h + th + inset * 2;
        Rectangle::new(Point::from((ox, oy)), Size::from((ow.max(1), oh.max(1))))
    }

    fn shell_backed_to_window_info(&self, id: u32, e: &ShellBackedWindowEntry) -> WindowInfo {
        let r = &e.client_global;
        WindowInfo {
            window_id: id,
            surface_id: id,
            title: e.title.clone(),
            app_id: e.app_id.clone(),
            wayland_client_pid: None,
            x: r.loc.x,
            y: r.loc.y,
            width: r.size.w.max(1),
            height: r.size.h.max(1),
            output_name: e.output_name.clone(),
            minimized: e.minimized,
            maximized: e.maximized,
            fullscreen: false,
            client_side_decoration: false,
        }
    }

    pub(crate) fn shell_backed_refresh_placements(&mut self) {
        let before: Vec<(u32, i32, i32, i32, i32)> = self
            .shell_ui_backed_placements
            .iter()
            .map(|p| {
                let g = &p.global_rect;
                (p.id, g.loc.x, g.loc.y, g.size.w, g.size.h)
            })
            .collect();
        self.shell_ui_backed_placements.clear();
        let Some(ws) = self.workspace_logical_bounds() else {
            if !before.is_empty() {
                self.shell_exclusion_zones_need_full_damage = true;
            }
            return;
        };
        let fz = self.shell_focused_ui_window_id;
        for (&id, e) in &self.shell_backed_windows {
            if e.minimized {
                continue;
            }
            let outer = self.shell_backed_outer_global_rect(e);
            let Some(clamped) = outer.intersection(ws) else {
                continue;
            };
            let Some(br) = self.shell_global_rect_to_buffer_rect(&clamped) else {
                continue;
            };
            let z = 30_000u32
                .saturating_add(id)
                .saturating_add(if fz == Some(id) { 500_000 } else { 0 });
            self.shell_ui_backed_placements.push(ShellUiWindowPlacement {
                id,
                z,
                global_rect: clamped,
                buffer_rect: br,
            });
        }
        let after: Vec<(u32, i32, i32, i32, i32)> = self
            .shell_ui_backed_placements
            .iter()
            .map(|p| {
                let g = &p.global_rect;
                (p.id, g.loc.x, g.loc.y, g.size.w, g.size.h)
            })
            .collect();
        if before != after {
            self.shell_exclusion_zones_need_full_damage = true;
        }
    }

    fn shell_backed_emit_geometry_messages(&mut self, id: u32, e: &ShellBackedWindowEntry) {
        let info = self.shell_backed_to_window_info(id, e);
        let Some(loc) = self.shell_window_info_to_output_local_layout(&info) else {
            return;
        };
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::WindowGeometry {
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
        });
    }

    fn shell_backed_emit_mapped_metas(&mut self, id: u32, e: &ShellBackedWindowEntry) {
        let info = self.shell_backed_to_window_info(id, e);
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
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::WindowMetadata {
            window_id: loc.window_id,
            surface_id: loc.surface_id,
            title: loc.title.clone(),
            app_id: loc.app_id.clone(),
        });
        self.shell_backed_emit_geometry_messages(id, e);
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
            .shell_backed_windows
            .get(&id)
            .is_some_and(|e| e.minimized);
        if unmin {
            if let Some(e) = self.shell_backed_windows.get_mut(&id) {
                e.minimized = false;
            }
            let snap = self
                .shell_backed_windows
                .get(&id)
                .expect("backed window")
                .clone();
            self.shell_backed_refresh_placements();
            self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::WindowState {
                window_id: id,
                minimized: false,
            });
            self.shell_backed_emit_geometry_messages(id, &snap);
            self.shell_reply_window_list();
            self.shell_focus_shell_ui_window(id);
            return;
        }
        if self.shell_backed_windows.contains_key(&id) {
            return;
        }
        self.shell_backed_windows.insert(
            id,
            ShellBackedWindowEntry {
                client_global,
                minimized: false,
                maximized: false,
                float_restore: Some(client_global),
                title: p.title,
                app_id: p.app_id,
                output_name: p.output_name,
            },
        );
        let e = self
            .shell_backed_windows
            .get(&id)
            .expect("inserted")
            .clone();
        self.shell_backed_emit_mapped_metas(id, &e);
        self.shell_backed_refresh_placements();
        self.shell_reply_window_list();
        self.shell_focus_shell_ui_window(id);
    }

    pub(crate) fn shell_backed_close_if_any(&mut self, window_id: u32) -> bool {
        if !self.shell_backed_windows.contains_key(&window_id) {
            return false;
        }
        self.cancel_shell_move_resize_for_window(window_id);
        if self.shell_focused_ui_window_id == Some(window_id) {
            self.shell_blur_shell_ui_focus();
        }
        self.shell_backed_windows.remove(&window_id);
        self.shell_ui_pointer_grab = None;
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::WindowUnmapped {
            window_id,
        });
        self.shell_backed_refresh_placements();
        self.shell_reply_window_list();
        true
    }

    pub(crate) fn shell_backed_minimize_if_any(&mut self, window_id: u32) -> bool {
        {
            let Some(e) = self.shell_backed_windows.get_mut(&window_id) else {
                return false;
            };
            if e.minimized {
                return true;
            }
            e.minimized = true;
        }
        self.cancel_shell_move_resize_for_window(window_id);
        if self.shell_focused_ui_window_id == Some(window_id) {
            self.shell_emit_shell_ui_focus_if_changed(None);
        }
        self.shell_backed_refresh_placements();
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::WindowState {
            window_id,
            minimized: true,
        });
        self.shell_reply_window_list();
        true
    }

    pub(crate) fn shell_backed_restore_minimized_if_any(&mut self, window_id: u32) -> bool {
        {
            let Some(e) = self.shell_backed_windows.get_mut(&window_id) else {
                return false;
            };
            if !e.minimized {
                return false;
            }
            e.minimized = false;
        }
        let snap = self
            .shell_backed_windows
            .get(&window_id)
            .expect("restored window")
            .clone();
        self.shell_backed_refresh_placements();
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::WindowState {
            window_id,
            minimized: false,
        });
        self.shell_backed_emit_geometry_messages(window_id, &snap);
        self.shell_reply_window_list();
        true
    }

    pub(crate) fn shell_backed_taskbar_activate(&mut self, window_id: u32) -> bool {
        if !self.shell_backed_windows.contains_key(&window_id) {
            return false;
        }
        let minned = self
            .shell_backed_windows
            .get(&window_id)
            .is_some_and(|e| e.minimized);
        if minned {
            self.shell_backed_restore_minimized_if_any(window_id);
            self.shell_focus_shell_ui_window(window_id);
            return true;
        }
        let ui = self.shell_focused_ui_window_id == Some(window_id);
        if ui {
            let _ = self.shell_backed_minimize_if_any(window_id);
        } else {
            self.shell_focus_shell_ui_window(window_id);
        }
        true
    }

    pub(crate) fn shell_move_try_begin_backed(&mut self, window_id: u32) -> bool {
        let Some(e) = self.shell_backed_windows.get(&window_id) else {
            return false;
        };
        if e.minimized {
            return false;
        }
        if let Some(prev) = self.shell_move_window_id {
            if prev != window_id {
                if self.shell_move_is_backed {
                    self.shell_move_end_backed_only(prev);
                } else {
                    self.shell_move_end(prev);
                }
            }
        }
        self.shell_resize_end_active();
        self.shell_move_window_id = Some(window_id);
        self.shell_move_is_backed = true;
        self.shell_move_pending_delta = (0, 0);
        self.shell_ipc_keyboard_to_cef = true;
        self.shell_focus_shell_ui_window(window_id);
        true
    }

    pub(crate) fn shell_move_flush_pending_deltas_backed(&mut self) {
        let Some(wid) = self.shell_move_window_id else {
            return;
        };
        if !self.shell_move_is_backed {
            return;
        }
        let (pdx, pdy) = self.shell_move_pending_delta;
        if pdx == 0 && pdy == 0 {
            return;
        }
        let Some(e) = self.shell_backed_windows.get_mut(&wid) else {
            self.shell_move_window_id = None;
            self.shell_move_is_backed = false;
            self.shell_move_pending_delta = (0, 0);
            return;
        };
        if e.maximized {
            e.maximized = false;
        }
        e.client_global.loc.x = e.client_global.loc.x.saturating_add(pdx);
        e.client_global.loc.y = e.client_global.loc.y.saturating_add(pdy);
        self.shell_move_pending_delta = (0, 0);
        let snap = e.clone();
        self.shell_backed_emit_geometry_messages(wid, &snap);
        self.shell_backed_refresh_placements();
    }

    pub(crate) fn shell_move_end_backed_only(&mut self, window_id: u32) {
        if self.shell_move_window_id != Some(window_id) || !self.shell_move_is_backed {
            return;
        }
        self.shell_move_flush_pending_deltas_backed();
        self.shell_move_window_id = None;
        self.shell_move_is_backed = false;
        self.shell_move_pending_delta = (0, 0);
        let snap = self
            .shell_backed_windows
            .get(&window_id)
            .map(|e| e.clone());
        if let Some(ref e) = snap {
            self.shell_backed_emit_geometry_messages(window_id, e);
        }
        self.shell_reply_window_list();
    }

    pub(crate) fn shell_resize_try_begin_backed(&mut self, window_id: u32, edges_wire: u32) -> bool {
        let edges = ResizeEdge::from_bits_truncate(edges_wire);
        if edges.is_empty() {
            return false;
        }
        let Some(e) = self.shell_backed_windows.get(&window_id) else {
            return false;
        };
        if e.minimized || e.maximized {
            return false;
        }
        let r = e.client_global;
        self.shell_resize_shell_grab = None;
        if let Some(mid) = self.shell_move_window_id {
            if self.shell_move_is_backed {
                self.shell_move_end_backed_only(mid);
            } else {
                self.shell_move_end(mid);
            }
        }
        if let Some(prev) = self.shell_resize_window_id {
            if self.shell_resize_is_backed {
                self.shell_resize_end_backed_only(prev);
            } else {
                self.shell_resize_end(prev);
            }
        }
        self.shell_resize_window_id = Some(window_id);
        self.shell_resize_is_backed = true;
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
        if !self.shell_resize_is_backed {
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
        let Some(e) = self.shell_backed_windows.get_mut(&wid) else {
            self.shell_resize_window_id = None;
            self.shell_resize_is_backed = false;
            self.shell_resize_edges = None;
            self.shell_resize_initial_rect = None;
            self.shell_resize_accum = (0.0, 0.0);
            return;
        };
        e.client_global = nr;
        let snap = e.clone();
        self.shell_backed_emit_geometry_messages(wid, &snap);
        self.shell_backed_refresh_placements();
    }

    pub(crate) fn shell_resize_end_backed_only(&mut self, window_id: u32) {
        if self.shell_resize_window_id != Some(window_id) || !self.shell_resize_is_backed {
            return;
        }
        self.shell_resize_window_id = None;
        self.shell_resize_is_backed = false;
        self.shell_resize_edges = None;
        self.shell_resize_initial_rect = None;
        self.shell_resize_accum = (0.0, 0.0);
        let snap = self
            .shell_backed_windows
            .get(&window_id)
            .map(|e| e.clone());
        if let Some(ref e) = snap {
            self.shell_backed_emit_geometry_messages(window_id, e);
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
        {
            let Some(e) = self.shell_backed_windows.get_mut(&window_id) else {
                return false;
            };
            if e.minimized {
                return true;
            }
            if layout_state == 1 {
                if let Some(work) = max_work {
                    if !e.maximized && e.float_restore.is_none() {
                        e.float_restore = Some(e.client_global);
                    }
                    e.client_global = work;
                    e.maximized = true;
                }
            } else {
                e.maximized = false;
                e.client_global = Rectangle::new(
                    Point::<i32, Logical>::from((gx, gy)),
                    Size::<i32, Logical>::from((gw.max(1), gh.max(1))),
                );
            }
        }
        let snap = self
            .shell_backed_windows
            .get(&window_id)
            .expect("backed window")
            .clone();
        self.shell_backed_emit_geometry_messages(window_id, &snap);
        self.shell_backed_refresh_placements();
        self.shell_reply_window_list();
        true
    }

    pub(crate) fn shell_backed_extend_window_list_snapshots(
        &self,
        windows: &mut Vec<shell_wire::ShellWindowSnapshot>,
    ) {
        for (&id, e) in &self.shell_backed_windows {
            if e.app_id.trim().is_empty() {
                continue;
            }
            let info = self.shell_backed_to_window_info(id, e);
            let i = self
                .shell_window_info_to_output_local_layout(&info)
                .unwrap_or_else(|| info.clone());
            windows.push(shell_wire::ShellWindowSnapshot {
                window_id: i.window_id,
                surface_id: i.surface_id,
                x: i.x,
                y: i.y,
                w: i.width,
                h: i.height,
                minimized: if i.minimized { 1 } else { 0 },
                maximized: if i.maximized { 1 } else { 0 },
                fullscreen: if i.fullscreen { 1 } else { 0 },
                client_side_decoration: if i.client_side_decoration { 1 } else { 0 },
                shell_flags: shell_wire::SHELL_WINDOW_FLAG_SHELL_HOSTED,
                title: i.title,
                app_id: i.app_id,
                output_name: i.output_name,
            });
        }
    }
}
