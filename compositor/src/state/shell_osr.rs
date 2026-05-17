use super::*;

pub(crate) struct ShellOsrState {
    pub(crate) shell_to_cef: Arc<Mutex<Option<Arc<crate::cef::ShellToCefLink>>>>,
    pub(crate) cef_to_compositor_tx: channel::Sender<crate::cef::compositor_tx::CefToCompositor>,
    pub(crate) shell_cef_handshake: Option<Arc<AtomicBool>>,
    pub(crate) shell_ipc_peer_pid: Option<i32>,
    pub(crate) shell_embedded_initial_handshake_done: bool,
    #[allow(dead_code)]
    pub(crate) shell_ipc_runtime_dir: Option<PathBuf>,
    pub(crate) shell_window_physical_px: (i32, i32),
    pub(crate) shell_has_frame: bool,
    pub(crate) shell_view_px: Option<(u32, u32)>,
    pub(crate) shell_frame_is_dmabuf: bool,
    pub(crate) shell_dmabuf: Option<Dmabuf>,
    pub(crate) shell_software_frame: Option<Vec<u8>>,
    pub(crate) shell_software_generation: u32,
    pub(crate) shell_dmabuf_generation: u32,
    pub(crate) shell_dmabuf_overlay_id: Id,
    pub(crate) shell_dmabuf_commit: CommitCounter,
    pub(crate) shell_frame_sequence: u64,
    pub(crate) shell_dmabuf_dirty_buffer: Vec<Rectangle<i32, Buffer>>,
    pub(crate) shell_dmabuf_dirty_force_full: bool,
    pub(crate) shell_dmabuf_next_force_full: bool,
    pub(crate) shell_presentation_fullscreen: bool,
    pub(crate) shell_exclusion_global: Vec<Rectangle<i32, Logical>>,
    pub(crate) shell_exclusion_floating: Vec<Rectangle<i32, Logical>>,
    pub(crate) shell_exclusion_overlay_open: bool,
    pub(crate) shell_exclusion_zones_need_full_damage: bool,
    pub(crate) shell_ui_windows: Vec<ShellUiWindowPlacement>,
    pub(crate) pending_shell_ui_windows: Option<PendingShellUiWindows>,
    pub(crate) shell_ui_windows_generation: u32,
    pub(crate) shell_ui_windows_shared_sequence: u64,
    pub(crate) shell_ui_windows_shared_path: PathBuf,
    pub(crate) shell_focused_ui_window_id: Option<u32>,
    pub(crate) shell_snapshot_epoch: u64,
    pub(crate) shell_last_sent_ui_focus_id: Option<u32>,
    pub(crate) shell_last_sent_focus_pair: Option<(Option<u32>, Option<u32>)>,
    pub(crate) shell_last_sent_window_order: Vec<(u32, u32)>,
    pub(crate) shell_visible_placements_cache: RefCell<Option<ShellVisiblePlacementsCache>>,
    pub(crate) shell_exclusion_shared_sequence: u64,
    pub(crate) shell_exclusion_shared_path: PathBuf,
    pub(crate) shell_chrome_titlebar_h: i32,
    pub(crate) shell_chrome_border_w: i32,
    pub(crate) shell_hosted_app_state: HashMap<u32, serde_json::Value>,
    pub(crate) shell_hosted_app_state_revision: u64,
}

pub(crate) struct ShellExclusionZonesApply {
    pub(crate) tray_strip_global: Option<Rectangle<i32, Logical>>,
}

pub(crate) struct ShellUiWindowsApply {
    pub(crate) focus_lost: bool,
    pub(crate) grab_lost: bool,
    pub(crate) changed: bool,
}

pub(crate) struct ShellUiFocusEmit {
    pub(crate) message: shell_wire::DecodedCompositorToShellMessage,
}

pub(crate) struct ShellFrameApply {
    pub(crate) commit: CommitCounter,
}

impl ShellOsrState {
    pub(crate) fn next_shell_hosted_app_state_revision(&mut self) -> u64 {
        self.shell_hosted_app_state_revision = self.shell_hosted_app_state_revision.wrapping_add(1);
        self.shell_hosted_app_state_revision
    }

    pub(crate) fn next_shell_snapshot_epoch(&mut self) -> u64 {
        self.shell_snapshot_epoch = self.shell_snapshot_epoch.wrapping_add(2).max(2);
        if self.shell_snapshot_epoch % 2 != 0 {
            self.shell_snapshot_epoch = self.shell_snapshot_epoch.wrapping_add(1);
        }
        self.shell_snapshot_epoch
    }

    pub(crate) fn shared_state_payload_is_stale(
        &self,
        kind: u32,
        sequence: u64,
        payload: &[u8],
        output_topology_revision: u64,
    ) -> bool {
        match shell_shared_state_payload_stale_reason(
            payload,
            output_topology_revision,
            self.shell_snapshot_epoch,
        ) {
            Some(ShellSharedStateStaleReason::OutputLayoutRevision {
                payload_revision,
                current_revision,
            }) => {
                let snapshot_epoch = if payload.len() >= 8 {
                    u64::from_le_bytes(payload[0..8].try_into().unwrap())
                } else {
                    0
                };
                tracing::warn!(
                    target: "derp_shell_shared_state",
                    kind,
                    sequence,
                    snapshot_epoch,
                    output_layout_revision = payload_revision,
                    current_output_layout_revision = current_revision,
                    "rejected stale shell shared-state payload"
                );
                true
            }
            None => false,
        }
    }

    pub(crate) fn point_in_shell_exclusion_zones(&self, pos: Point<f64, Logical>) -> bool {
        let px = pos.x;
        let py = pos.y;
        if self.shell_exclusion_global.is_empty() && self.shell_exclusion_floating.is_empty() {
            return false;
        }
        for r in &self.shell_exclusion_global {
            let x1 = r.loc.x as f64;
            let y1 = r.loc.y as f64;
            let x2 = x1 + r.size.w.max(0) as f64;
            let y2 = y1 + r.size.h.max(0) as f64;
            if px >= x1 && px < x2 && py >= y1 && py < y2 {
                return true;
            }
        }
        for r in &self.shell_exclusion_floating {
            let x1 = r.loc.x as f64;
            let y1 = r.loc.y as f64;
            let x2 = x1 + r.size.w.max(0) as f64;
            let y2 = y1 + r.size.h.max(0) as f64;
            if px >= x1 && px < x2 && py >= y1 && py < y2 {
                return true;
            }
        }
        false
    }

    pub(crate) fn shell_placement_stack_z(placement: &ShellUiWindowPlacement, stack_z: u32) -> u32 {
        if stack_z > 0 {
            stack_z
        } else {
            placement.z
        }
    }

    pub(crate) fn shell_placement_renders_above_window(
        placement: &ShellUiWindowPlacement,
        window_id: u32,
        native_z: u32,
        placement_z: u32,
    ) -> bool {
        let _ = window_id;
        placement_z > native_z || (placement_z == native_z && placement.id > window_id)
    }

    pub(crate) fn shell_ui_placement_topmost_at<F>(
        pos: Point<f64, Logical>,
        placements: &[ShellUiWindowPlacement],
        mut stack_z_for: F,
    ) -> Option<ShellUiWindowPlacement>
    where
        F: FnMut(u32) -> u32,
    {
        let px = pos.x;
        let py = pos.y;
        let mut best: Option<ShellUiWindowPlacement> = None;
        for w in placements {
            let g = &w.global_rect;
            let x2 = g.loc.x.saturating_add(g.size.w) as f64;
            let y2 = g.loc.y.saturating_add(g.size.h) as f64;
            if px >= g.loc.x as f64 && px < x2 && py >= g.loc.y as f64 && py < y2 {
                if best.as_ref().is_none_or(|cur| {
                    let wz = Self::shell_placement_stack_z(w, stack_z_for(w.id));
                    let cz = Self::shell_placement_stack_z(cur, stack_z_for(cur.id));
                    wz > cz || (wz == cz && w.id > cur.id)
                }) {
                    best = Some(w.clone());
                }
            }
        }
        best
    }

    pub(crate) fn shell_visible_placements_cache(
        &self,
        stamp: ShellVisiblePlacementsStamp,
        frames: Vec<ShellUiWindowPlacement>,
        ui_windows: Vec<ShellUiWindowPlacement>,
    ) -> ShellVisiblePlacementsCache {
        if let Some(cache) = self
            .shell_visible_placements_cache
            .borrow()
            .as_ref()
            .filter(|cache| cache.stamp == stamp)
            .cloned()
        {
            return cache;
        }
        let mut all = ui_windows;
        let shell_ids: HashSet<u32> = all.iter().map(|w| w.id).collect();
        all.extend(
            frames
                .iter()
                .filter(|w| !shell_ids.contains(&w.id))
                .cloned(),
        );
        let cache = ShellVisiblePlacementsCache { stamp, all, frames };
        *self.shell_visible_placements_cache.borrow_mut() = Some(cache.clone());
        cache
    }

    pub(crate) fn shell_global_rect_to_buffer_mapping(
        &self,
        global: &Rectangle<i32, Logical>,
        shell_output_logical_size: Option<(u32, u32)>,
        workspace_bounds: Option<Rectangle<i32, Logical>>,
    ) -> Option<(Rectangle<i32, Logical>, Rectangle<i32, Buffer>)> {
        let (buf_w, buf_h) = self.shell_view_px?;
        let content_h = buf_h.max(1);
        let (lw_u, lh_u) = shell_output_logical_size?;
        let lw = lw_u as i32;
        let lh = lh_u as i32;
        let (ox, oy, cw_l, ch_l) = crate::shell::shell_letterbox::letterbox_logical(
            Size::from((lw, lh)),
            buf_w,
            content_h,
        )?;
        let ws = workspace_bounds?;
        let g = global.intersection(ws)?;
        if g.size.w < 1 || g.size.h < 1 {
            return None;
        }
        let wf = g.size.w.max(1) as f64;
        let hf = g.size.h.max(1) as f64;
        let wsf = ws.size.w.max(1) as f64;
        let hsf = ws.size.h.max(1) as f64;
        let mut min_x = i32::MAX;
        let mut min_y = i32::MAX;
        let mut max_x = i32::MIN;
        let mut max_y = i32::MIN;
        let mut any = false;
        for k in 0..4u8 {
            let gx = g.loc.x as f64 + if (k & 1) == 0 { 0.25 } else { wf - 0.25 };
            let gy = g.loc.y as f64 + if (k & 2) == 0 { 0.25 } else { hf - 0.25 };
            let nx = ((gx - ws.loc.x as f64) / wsf).clamp(0.0, 1.0);
            let ny = ((gy - ws.loc.y as f64) / hsf).clamp(0.0, 1.0);
            let lx = nx * lw as f64 - ox as f64;
            let ly = ny * lh as f64 - oy as f64;
            if let Some((bx, by)) = crate::shell::shell_letterbox::local_in_letterbox_to_buffer_px(
                lx, ly, cw_l, ch_l, buf_w, content_h,
            ) {
                any = true;
                min_x = min_x.min(bx);
                min_y = min_y.min(by);
                max_x = max_x.max(bx);
                max_y = max_y.max(by);
            }
        }
        if !any {
            return None;
        }
        Some((
            g,
            Rectangle::new(
                Point::new(min_x, min_y),
                Size::new((max_x - min_x + 1).max(1), (max_y - min_y + 1).max(1)),
            ),
        ))
    }

    pub(crate) fn shell_global_rect_to_buffer_rect(
        &self,
        global: &Rectangle<i32, Logical>,
        shell_output_logical_size: Option<(u32, u32)>,
        workspace_bounds: Option<Rectangle<i32, Logical>>,
    ) -> Option<Rectangle<i32, Buffer>> {
        self.shell_global_rect_to_buffer_mapping(
            global,
            shell_output_logical_size,
            workspace_bounds,
        )
        .map(|(_, buffer_rect)| buffer_rect)
    }

    pub(crate) fn apply_shell_exclusion_zones_payload(
        &mut self,
        payload: &[u8],
        output_topology_revision: u64,
        workspace_bounds: Option<Rectangle<i32, Logical>>,
        current_tray_strip: Option<Rectangle<i32, Logical>>,
    ) -> Option<ShellExclusionZonesApply> {
        if payload.len() < shell_wire::SHELL_SHARED_STATE_PREFIX_BYTES {
            return None;
        }
        let snapshot_epoch = u64::from_le_bytes(payload[0..8].try_into().unwrap());
        let output_layout_revision = u64::from_le_bytes(payload[8..16].try_into().unwrap());
        if output_layout_revision > 0 && output_layout_revision < output_topology_revision {
            tracing::warn!(
                target: "derp_shell_shared_state",
                snapshot_epoch,
                output_layout_revision,
                current_output_layout_revision = output_topology_revision,
                "ignoring stale shell exclusion payload"
            );
            return None;
        }
        let payload = &payload[shell_wire::SHELL_SHARED_STATE_PREFIX_BYTES..];
        if payload.len() < shell_wire::SHELL_SHARED_STATE_EXCLUSION_HEADER_BYTES {
            return None;
        }
        let mut cursor = shell_wire::WireCursor::new(payload);
        let rect_count = cursor.read_u32().map(|count| count as usize)?;
        let has_tray_strip = cursor.read_u32()?;
        if has_tray_strip > 1 {
            return None;
        }
        let base_len = shell_wire::SHELL_SHARED_STATE_EXCLUSION_HEADER_BYTES
            .saturating_add(
                rect_count.saturating_mul(shell_wire::SHELL_SHARED_STATE_EXCLUSION_RECT_BYTES),
            )
            .saturating_add(if has_tray_strip == 1 {
                shell_wire::SHELL_SHARED_STATE_EXCLUSION_TRAY_STRIP_BYTES
            } else {
                0
            });
        if payload.len() < base_len {
            return None;
        }
        let mut overlay_open = false;
        let mut next_floating: Vec<Rectangle<i32, Logical>> = Vec::new();
        if payload.len() > base_len {
            if payload.len()
                < base_len + shell_wire::SHELL_SHARED_STATE_EXCLUSION_FLOATING_HEADER_BYTES
            {
                return None;
            }
            let mut floating_cursor = shell_wire::WireCursor::new(&payload[base_len..]);
            overlay_open = floating_cursor.read_u32().map(|open| open != 0)?;
            let fc = floating_cursor.read_u32().map(|count| count as usize)?;
            let expected = base_len
                + shell_wire::SHELL_SHARED_STATE_EXCLUSION_FLOATING_HEADER_BYTES
                + fc.saturating_mul(shell_wire::SHELL_SHARED_STATE_EXCLUSION_RECT_BYTES);
            if expected != payload.len() {
                return None;
            }
            for _ in 0..fc {
                let x = floating_cursor.read_i32()?;
                let y = floating_cursor.read_i32()?;
                let w = floating_cursor.read_i32()?;
                let h = floating_cursor.read_i32()?;
                let _ = floating_cursor.read_u32()?;
                next_floating.push(Rectangle::new(
                    Point::<i32, Logical>::from((x, y)),
                    Size::<i32, Logical>::from((w.max(1), h.max(1))),
                ));
            }
        } else if payload.len() != base_len {
            return None;
        }
        let Some(ws) = workspace_bounds else {
            self.shell_exclusion_global.clear();
            self.shell_exclusion_floating.clear();
            self.shell_exclusion_overlay_open = false;
            self.shell_exclusion_zones_need_full_damage = true;
            self.shell_dmabuf_dirty_force_full = true;
            return Some(ShellExclusionZonesApply {
                tray_strip_global: None,
            });
        };
        let mut next_global: Vec<Rectangle<i32, Logical>> = Vec::new();
        for _ in 0..rect_count {
            let x = cursor.read_i32()?;
            let y = cursor.read_i32()?;
            let w = cursor.read_i32()?;
            let h = cursor.read_i32()?;
            let window_id = cursor.read_u32()?;
            let r = Rectangle::new(
                Point::<i32, Logical>::from((x, y)),
                Size::<i32, Logical>::from((w.max(1), h.max(1))),
            );
            let Some(clamped) = r.intersection(ws) else {
                continue;
            };
            if window_id == 0 {
                next_global.push(clamped);
            }
        }
        let next_tray_strip = if has_tray_strip == 0 {
            None
        } else {
            let x = cursor.read_i32()?;
            let y = cursor.read_i32()?;
            let w = cursor.read_i32()?;
            let h = cursor.read_i32()?;
            if w < 1 || h < 1 {
                None
            } else {
                Rectangle::new(
                    Point::<i32, Logical>::from((x, y)),
                    Size::<i32, Logical>::from((w.max(1), h.max(1))),
                )
                .intersection(ws)
            }
        };
        next_floating.retain_mut(|r| {
            if let Some(c) = r.intersection(ws) {
                *r = c;
                true
            } else {
                false
            }
        });
        let global_changed = next_global != self.shell_exclusion_global;
        let tray_changed = next_tray_strip != current_tray_strip;
        let floating_changed = next_floating != self.shell_exclusion_floating;
        let overlay_changed = overlay_open != self.shell_exclusion_overlay_open;
        self.shell_exclusion_global = next_global;
        self.shell_exclusion_floating = next_floating;
        self.shell_exclusion_overlay_open = overlay_open;
        if global_changed || tray_changed || floating_changed || overlay_changed {
            self.shell_exclusion_zones_need_full_damage = true;
            self.shell_dmabuf_dirty_force_full = true;
        }
        Some(ShellExclusionZonesApply {
            tray_strip_global: next_tray_strip,
        })
    }

    pub(crate) fn apply_shell_ui_windows_payload(
        &mut self,
        payload: &[u8],
        output_topology_revision: u64,
        shell_output_logical_size: Option<(u32, u32)>,
        workspace_bounds: Option<Rectangle<i32, Logical>>,
        stack_z_by_id: &HashMap<u32, u32>,
    ) -> Option<ShellUiWindowsApply> {
        if payload.len() < shell_wire::SHELL_SHARED_STATE_PREFIX_BYTES {
            return None;
        }
        let snapshot_epoch = u64::from_le_bytes(payload[0..8].try_into().unwrap());
        let output_layout_revision = u64::from_le_bytes(payload[8..16].try_into().unwrap());
        if output_layout_revision > 0 && output_layout_revision < output_topology_revision {
            tracing::warn!(
                target: "derp_shell_shared_state",
                snapshot_epoch,
                output_layout_revision,
                current_output_layout_revision = output_topology_revision,
                "ignoring stale shell ui windows payload"
            );
            return None;
        }
        let payload = &payload[shell_wire::SHELL_SHARED_STATE_PREFIX_BYTES..];
        const MAX: usize = shell_wire::MAX_SHELL_UI_WINDOWS as usize;
        if payload.len() < shell_wire::SHELL_SHARED_STATE_UI_WINDOWS_HEADER_BYTES {
            return None;
        }
        let mut cursor = shell_wire::WireCursor::new(payload);
        let generation = cursor.read_u32()?;
        let count = cursor.read_u32().map(|count| count as usize)?;
        let need = count
            .checked_mul(shell_wire::SHELL_SHARED_STATE_UI_WINDOWS_ROW_BYTES)
            .and_then(|count_len| {
                shell_wire::SHELL_SHARED_STATE_UI_WINDOWS_HEADER_BYTES.checked_add(count_len)
            });
        if need != Some(payload.len()) {
            return None;
        }
        let Some(ws) = workspace_bounds else {
            let changed =
                !self.shell_ui_windows.is_empty() || self.pending_shell_ui_windows.is_some();
            self.shell_ui_windows.clear();
            if self.pending_shell_ui_windows.take().is_some() {
                crate::cef::begin_frame_diag::note_shell_ui_windows_pending_dropped();
            }
            self.shell_ui_windows_generation = generation;
            return Some(ShellUiWindowsApply {
                focus_lost: false,
                grab_lost: false,
                changed,
            });
        };
        let mut rows = Vec::new();
        for _ in 0..count {
            let id = cursor.read_u32()?;
            let gx = cursor.read_i32()?;
            let gy = cursor.read_i32()?;
            let gw = cursor.read_u32()?;
            let gh = cursor.read_u32()?;
            let sent_z = cursor.read_u32()?;
            let _ = cursor.read_u32()?;
            if id == 0 || gw == 0 || gh == 0 {
                continue;
            }
            let stack_z = stack_z_by_id.get(&id).copied().unwrap_or(0);
            let z = if stack_z > 0 { stack_z } else { sent_z };
            rows.push((id, gx, gy, gw as i32, gh as i32, z));
        }
        rows.sort_by(|a, b| a.5.cmp(&b.5).then_with(|| a.0.cmp(&b.0)));
        let mut out = Vec::new();
        for (id, gx, gy, gw, gh, z) in rows.into_iter().take(MAX) {
            let gr = Rectangle::new(
                Point::<i32, Logical>::from((gx, gy)),
                Size::<i32, Logical>::from((gw.max(1), gh.max(1))),
            );
            let Some(clamped) = gr.intersection(ws) else {
                continue;
            };
            let Some(br) = self.shell_global_rect_to_buffer_rect(
                &clamped,
                shell_output_logical_size,
                workspace_bounds,
            ) else {
                continue;
            };
            out.push(ShellUiWindowPlacement {
                id,
                z,
                global_rect: clamped,
                buffer_rect: br,
            });
        }
        let changed = self
            .pending_shell_ui_windows
            .as_ref()
            .is_none_or(|pending| pending.generation != generation || pending.windows != out);
        crate::cef::begin_frame_diag::note_shell_ui_windows_staged(out.len());
        self.pending_shell_ui_windows = Some(PendingShellUiWindows {
            generation,
            staged_shell_frame_sequence: self.shell_frame_sequence,
            windows: out,
        });
        Some(ShellUiWindowsApply {
            focus_lost: false,
            grab_lost: false,
            changed,
        })
    }

    pub(crate) fn promote_pending_shell_ui_windows(
        &mut self,
        focused_is_shell_hosted: bool,
        pointer_grab_id: Option<u32>,
        pointer_grab_is_shell_hosted: bool,
    ) -> Option<ShellUiWindowsApply> {
        let pending = self.pending_shell_ui_windows.take()?;
        let changed = pending.windows != self.shell_ui_windows
            || pending.generation != self.shell_ui_windows_generation;
        let wait_frames = self
            .shell_frame_sequence
            .saturating_sub(pending.staged_shell_frame_sequence);
        self.shell_ui_windows = pending.windows;
        self.shell_ui_windows_generation = pending.generation;
        crate::cef::begin_frame_diag::note_shell_ui_windows_promoted(
            self.shell_ui_windows.len(),
            changed,
            wait_frames,
        );
        let focus_lost = self.shell_focused_ui_window_id.is_some_and(|fid| {
            !self.shell_ui_windows.iter().any(|w| w.id == fid) && !focused_is_shell_hosted
        });
        let grab_lost = pointer_grab_id.is_some_and(|gid| {
            !self.shell_ui_windows.iter().any(|w| w.id == gid) && !pointer_grab_is_shell_hosted
        });
        if changed {
            self.shell_exclusion_zones_need_full_damage = true;
            self.shell_dmabuf_dirty_force_full = true;
        }
        Some(ShellUiWindowsApply {
            focus_lost,
            grab_lost,
            changed,
        })
    }

    pub(crate) fn shell_cef_active(&self) -> bool {
        self.shell_to_cef
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false)
    }

    pub(crate) fn shell_nudge_cef_repaint(&self) {
        let Ok(g) = self.shell_to_cef.lock() else {
            tracing::warn!(target: "derp_hotplug_shell", "shell_nudge_cef_repaint shell_to_cef lock poisoned");
            return;
        };
        if let Some(link) = g.as_ref() {
            link.invalidate_view(
                crate::cef::begin_frame_diag::ShellViewInvalidateReason::ForcedRepaint,
            );
        } else {
            tracing::warn!(target: "derp_hotplug_shell", "shell_nudge_cef_repaint no ShellToCefLink");
        }
    }

    pub(crate) fn shell_force_next_dmabuf_full_damage(&mut self) {
        self.shell_dmabuf_next_force_full = true;
    }

    pub(crate) fn shell_emit_shell_ui_focus_if_changed(
        &mut self,
        id: Option<u32>,
    ) -> Option<ShellUiFocusEmit> {
        self.shell_focused_ui_window_id = id;
        if id == self.shell_last_sent_ui_focus_id {
            return None;
        }
        self.shell_last_sent_ui_focus_id = id;
        let (surface_id, window_id) = match id {
            None => (None, None),
            Some(w) => (Some(w), Some(w)),
        };
        self.shell_exclusion_zones_need_full_damage = true;
        self.shell_dmabuf_dirty_force_full = true;
        Some(ShellUiFocusEmit {
            message: shell_wire::DecodedCompositorToShellMessage::FocusChanged {
                surface_id,
                window_id,
            },
        })
    }

    pub(crate) fn shell_focus_message(
        window_id: Option<u32>,
        surface_id: Option<u32>,
    ) -> shell_wire::DecodedCompositorToShellMessage {
        shell_wire::DecodedCompositorToShellMessage::FocusChanged {
            surface_id,
            window_id,
        }
    }

    pub(crate) fn shell_focus_snapshot_message<F, G>(
        &self,
        mut window_is_valid: F,
        mut surface_id_for_window: G,
    ) -> shell_wire::DecodedCompositorToShellMessage
    where
        F: FnMut(u32) -> bool,
        G: FnMut(u32) -> Option<u32>,
    {
        let (surface_id, window_id) = self.shell_last_sent_focus_pair.unwrap_or((None, None));
        let window_id = window_id.filter(|window_id| window_is_valid(*window_id));
        let surface_id =
            window_id.and_then(|window_id| surface_id_for_window(window_id).or(surface_id));
        Self::shell_focus_message(window_id, surface_id)
    }

    pub(crate) fn shell_interaction_state_message(
        revision: u64,
        interaction_serial: u64,
        pointer: Point<i32, Logical>,
        move_window_id: Option<u32>,
        resize_window_id: Option<u32>,
        move_proxy_window_id: u32,
        move_capture_window_id: u32,
        move_visual: Option<shell_wire::CompositorInteractionVisual>,
        resize_visual: Option<shell_wire::CompositorInteractionVisual>,
        window_switcher_selected_window_id: Option<u32>,
        super_held: bool,
    ) -> shell_wire::DecodedCompositorToShellMessage {
        shell_wire::DecodedCompositorToShellMessage::InteractionState {
            revision,
            interaction_serial,
            pointer_x: pointer.x,
            pointer_y: pointer.y,
            move_window_id: move_window_id.unwrap_or(0),
            resize_window_id: resize_window_id.unwrap_or(0),
            move_proxy_window_id,
            move_capture_window_id,
            move_visual,
            resize_visual,
            window_switcher_selected_window_id: window_switcher_selected_window_id.unwrap_or(0),
            super_held,
        }
    }

    pub(crate) fn prepare_shell_send_to_cef(
        &mut self,
        msg: &shell_wire::DecodedCompositorToShellMessage,
    ) -> bool {
        if let shell_wire::DecodedCompositorToShellMessage::FocusChanged {
            surface_id,
            window_id,
        } = msg
        {
            let pair = (*surface_id, *window_id);
            if self.shell_last_sent_focus_pair == Some(pair) {
                return false;
            }
            self.shell_last_sent_focus_pair = Some(pair);
        }
        true
    }

    pub(crate) fn shell_send_to_cef_link(
        &self,
        msg: shell_wire::DecodedCompositorToShellMessage,
        authoritative_snapshot: Option<Vec<shell_wire::DecodedCompositorToShellMessage>>,
        snapshot_epoch: Option<u64>,
        live_epoch: u64,
        workspace_state_message: Option<shell_wire::DecodedCompositorToShellMessage>,
    ) {
        let Ok(g) = self.shell_to_cef.lock() else {
            return;
        };
        if let Some(link) = g.as_ref() {
            link.send_with_snapshot(
                msg,
                authoritative_snapshot,
                snapshot_epoch,
                Some(live_epoch),
            );
            if let Some(workspace_state_message) = workspace_state_message {
                link.send_with_snapshot(workspace_state_message, None, None, Some(live_epoch));
            }
        }
    }

    pub(crate) fn shell_authoritative_snapshot_messages(
        msg: &shell_wire::DecodedCompositorToShellMessage,
        output_layout: Option<shell_wire::DecodedCompositorToShellMessage>,
        window_list: shell_wire::DecodedCompositorToShellMessage,
        window_order: shell_wire::DecodedCompositorToShellMessage,
        focus: shell_wire::DecodedCompositorToShellMessage,
        workspace_state: Option<shell_wire::DecodedCompositorToShellMessage>,
        hosted_app_state: shell_wire::DecodedCompositorToShellMessage,
        command_palette_state: shell_wire::DecodedCompositorToShellMessage,
        interaction_state: shell_wire::DecodedCompositorToShellMessage,
        native_drag_preview: Option<shell_wire::DecodedCompositorToShellMessage>,
        keyboard_layout: shell_wire::DecodedCompositorToShellMessage,
        tray_hints: shell_wire::DecodedCompositorToShellMessage,
        tray_sni: shell_wire::DecodedCompositorToShellMessage,
    ) -> Option<Vec<shell_wire::DecodedCompositorToShellMessage>> {
        let mut messages = Vec::new();
        if matches!(
            msg,
            shell_wire::DecodedCompositorToShellMessage::OutputGeometry { .. }
        ) {
            messages.push(msg.clone());
        }
        if let Some(output_layout) = output_layout {
            messages.push(output_layout);
        }
        messages.push(window_list);
        messages.push(window_order);
        messages.push(focus);
        if let Some(workspace_state) = workspace_state {
            messages.push(workspace_state);
        }
        messages.push(hosted_app_state);
        messages.push(command_palette_state);
        messages.push(interaction_state);
        if let Some(native_drag_preview) = native_drag_preview {
            messages.push(native_drag_preview);
        }
        messages.push(keyboard_layout);
        messages.push(tray_hints);
        messages.push(tray_sni);
        if messages.is_empty() {
            None
        } else {
            Some(messages)
        }
    }

    pub(crate) fn shell_embedded_notify_output_ready(
        &mut self,
        output_ready: bool,
        cef_active: bool,
    ) {
        if self.shell_cef_handshake.is_none()
            || self.shell_embedded_initial_handshake_done
            || !output_ready
            || !cef_active
        {
            return;
        }
        self.shell_embedded_initial_handshake_done = true;
    }

    pub(crate) fn set_delivery_ready(&self, ready: bool) {
        if let Ok(g) = self.shell_to_cef.lock() {
            if let Some(link) = g.as_ref() {
                link.set_delivery_ready(ready);
            }
        }
    }

    pub(crate) fn shell_on_shell_client_connected(&mut self) {
        self.shell_embedded_initial_handshake_done = true;
        self.set_delivery_ready(true);
    }

    pub(crate) fn shell_ipc_on_shell_load_success(&self) {
        self.set_delivery_ready(true);
    }

    pub(crate) fn hosted_app_state_broadcast_json(&self) -> String {
        let mut m = serde_json::Map::new();
        for (k, v) in &self.shell_hosted_app_state {
            m.insert(k.to_string(), v.clone());
        }
        serde_json::json!({ "byWindowId": serde_json::Value::Object(m) }).to_string()
    }

    pub(crate) fn shell_hosted_app_state_message(
        &self,
    ) -> shell_wire::DecodedCompositorToShellMessage {
        shell_wire::DecodedCompositorToShellMessage::ShellHostedAppState {
            revision: self.shell_hosted_app_state_revision,
            state_json: self.hosted_app_state_broadcast_json(),
        }
    }

    pub(crate) fn apply_shell_hosted_window_state_json<F>(
        &mut self,
        json: &str,
        is_shell_hosted: F,
    ) -> bool
    where
        F: FnOnce(u32) -> bool,
    {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
            return false;
        };
        let Some(window_id) = v
            .get("window_id")
            .and_then(|x| x.as_u64())
            .map(|u| u as u32)
        else {
            return false;
        };
        let Some(kind) = v.get("kind").and_then(|x| x.as_str()) else {
            return false;
        };
        if kind != "file_browser"
            && kind != "image_viewer"
            && kind != "video_viewer"
            && kind != "text_editor"
            && kind != "pdf_viewer"
        {
            return false;
        }
        if !is_shell_hosted(window_id) {
            return false;
        }
        let state = match v.get("state") {
            Some(s) if s.is_object() => s.clone(),
            Some(s) if s.is_null() => serde_json::json!({}),
            _ => return false,
        };
        self.shell_hosted_app_state.insert(window_id, state);
        true
    }

    fn dirty_bbox_covers_buffer(dirty: &[(i32, i32, i32, i32)], buf_w: u32, buf_h: u32) -> bool {
        const FRAC_NUM: i64 = 98;
        const FRAC_DEN: i64 = 100;
        let mut min_x = i32::MAX;
        let mut min_y = i32::MAX;
        let mut max_x = i32::MIN;
        let mut max_y = i32::MIN;
        for &(x, y, w, h) in dirty {
            max_x = max_x.max(x.saturating_add(w));
            max_y = max_y.max(y.saturating_add(h));
            min_x = min_x.min(x);
            min_y = min_y.min(y);
        }
        let bw = buf_w as i64;
        let bh = buf_h as i64;
        if bw <= 0 || bh <= 0 {
            return true;
        }
        let rw = (max_x as i64 - min_x as i64).max(0);
        let rh = (max_y as i64 - min_y as i64).max(0);
        rw * rh * FRAC_DEN >= bw * bh * FRAC_NUM
    }

    fn frame_size_matches_expected(&self, width: u32, height: u32, workspace_ready: bool) -> bool {
        let (pw, ph) = self.shell_window_physical_px;
        if pw <= 0 || ph <= 0 || !workspace_ready {
            return true;
        }
        let exp_w = u32::try_from(pw).unwrap_or(width).max(1);
        let exp_h = u32::try_from(ph).unwrap_or(height).max(1);
        const LO: u64 = 97;
        const HI: u64 = 103;
        let ew = exp_w as u64;
        let eh = exp_h as u64;
        let ww = width as u64;
        let hh = height as u64;
        ww * 100 >= ew * LO && ww * 100 <= ew * HI && hh * 100 >= eh * LO && hh * 100 <= eh * HI
    }

    fn prepare_frame_damage(
        &mut self,
        width: u32,
        height: u32,
        dirty_buffer: Option<Vec<(i32, i32, i32, i32)>>,
    ) -> (bool, bool, bool, bool, Option<usize>) {
        let force_env = std::env::var_os("DERP_SHELL_OSR_FULL_DAMAGE").is_some_and(|v| {
            v.as_os_str() == std::ffi::OsStr::new("1")
                || v.as_os_str()
                    .eq_ignore_ascii_case(std::ffi::OsStr::new("true"))
        });
        let resized = self.shell_view_px.is_some_and(|p| p != (width, height));
        let dirty_supplied_len = dirty_buffer.as_ref().map(|v| v.len());
        let dirty_list = dirty_buffer.filter(|v| !v.is_empty());
        let bbox_full = dirty_list
            .as_ref()
            .map(|v| Self::dirty_bbox_covers_buffer(v, width, height))
            .unwrap_or(true);
        let pending_force_full = self.shell_dmabuf_next_force_full;
        self.shell_dmabuf_next_force_full = false;
        let mut force_full =
            force_env || pending_force_full || resized || dirty_list.is_none() || bbox_full;
        let buffer_rects: Vec<Rectangle<i32, Buffer>> = if let Some(ref dl) = dirty_list {
            let mut rects = Vec::with_capacity(dl.len());
            for &(x, y, w, h) in dl {
                if w > 0 && h > 0 {
                    rects.push(Rectangle::new(
                        Point::<i32, Buffer>::from((x, y)),
                        Size::<i32, Buffer>::from((w, h)),
                    ));
                }
            }
            if !force_full && rects.is_empty() {
                force_full = true;
            }
            rects
        } else {
            Vec::new()
        };
        self.shell_dmabuf_dirty_force_full = force_full;
        if force_full {
            self.shell_dmabuf_dirty_buffer.clear();
        } else {
            self.shell_dmabuf_dirty_buffer = buffer_rects;
        }
        (
            force_full,
            force_env,
            pending_force_full,
            bbox_full,
            dirty_supplied_len,
        )
    }

    pub(crate) fn apply_shell_frame_dmabuf(
        &mut self,
        width: u32,
        height: u32,
        drm_format: u32,
        modifier: u64,
        flags: u32,
        planes: &[shell_wire::FrameDmabufPlane],
        fds: &mut Vec<OwnedFd>,
        dirty_buffer: Option<Vec<(i32, i32, i32, i32)>>,
        workspace_ready: bool,
        shell_output_logical_size: Option<(u32, u32)>,
    ) -> Result<ShellFrameApply, &'static str> {
        if width == 0 || height == 0 {
            fds.clear();
            return Err("bad dimensions");
        }
        if planes.is_empty() || planes.len() != fds.len() {
            fds.clear();
            return Err("dmabuf plane/fd mismatch");
        }
        if !self.frame_size_matches_expected(width, height, workspace_ready) {
            fds.clear();
            self.shell_nudge_cef_repaint();
            tracing::debug!(
                target: "derp_hotplug_shell",
                width,
                height,
                "apply_shell_frame_dmabuf reject mismatched size pending CEF resize paint"
            );
            return Err("dmabuf size mismatch shell_window_physical_px");
        }
        let resized = self.shell_view_px.is_some_and(|p| p != (width, height));
        let (force_full, force_env, pending_force_full, bbox_full, dirty_supplied_len) =
            self.prepare_frame_damage(width, height, dirty_buffer);
        let format = Fourcc::try_from(drm_format).map_err(|_| "unrecognized drm fourcc")?;
        let modifier_u64_raw = modifier;
        let modifier = Modifier::from(modifier_u64_raw);
        let dmabuf_flags = if (flags & shell_wire::DMABUF_FLAG_Y_INVERT) != 0 {
            DmabufFlags::Y_INVERT
        } else {
            DmabufFlags::empty()
        };
        let mut b = Dmabuf::builder(
            Size::<i32, Buffer>::from((width as i32, height as i32)),
            format,
            modifier,
            dmabuf_flags,
        );
        for (p, fd) in planes.iter().zip(fds.drain(..)) {
            let off = u32::try_from(p.offset).map_err(|_| "plane offset too large")?;
            if !b.add_plane(fd, p.plane_idx, off, p.stride) {
                return Err("dmabuf add_plane failed");
            }
        }
        let Some(dmabuf) = b.build() else {
            return Err("dmabuf build");
        };
        self.shell_dmabuf_commit.increment();
        self.shell_frame_sequence = self.shell_frame_sequence.wrapping_add(1);
        self.shell_dmabuf = Some(dmabuf);
        self.shell_software_frame = None;
        self.shell_frame_is_dmabuf = true;
        self.shell_has_frame = true;
        self.shell_view_px = Some((width, height));
        self.sync_osr_physical_from_frame(width, height);
        if resized {
            tracing::warn!(
                target: "derp_hotplug_shell",
                width,
                height,
                "apply_shell_frame_dmabuf OSR size changed shell_has_frame true"
            );
        }
        tracing::debug!(
            target: "derp_shell_osr_damage",
            width,
            height,
            force_full,
            force_env,
            pending_force_full,
            resized,
            dirty_supplied = dirty_supplied_len,
            bbox_full,
            partial_rects = self.shell_dmabuf_dirty_buffer.len(),
            commit = ?self.shell_dmabuf_commit,
            "apply_shell_frame_dmabuf damage"
        );
        tracing::debug!(
            target: "derp_shell_dmabuf",
            width,
            height,
            drm_format,
            drm_format_hex = drm_format,
            modifier = ?modifier,
            modifier_u64 = modifier_u64_raw,
            flags,
            plane_count = planes.len(),
            planes = ?planes
                .iter()
                .map(|p| (p.plane_idx, p.stride, p.offset))
                .collect::<Vec<_>>(),
            fourcc_resolved = ?format,
            "apply_shell_frame_dmabuf (IPC from cef_host)"
        );
        if let Some((lw, lh)) = shell_output_logical_size {
            let (pw, ph) = self.shell_window_physical_px;
            if lw > 0 && lh > 0 && pw > 0 && ph > 0 {
                let exp_w = u32::try_from(pw).unwrap_or(width).max(1);
                let exp_h = u32::try_from(ph).unwrap_or(height).max(1);
                if width * 100 < exp_w * 97 || height * 100 < exp_h * 97 {
                    use std::sync::Once;
                    static SHELL_DMABUF_UNDERSIZED: Once = Once::new();
                    SHELL_DMABUF_UNDERSIZED.call_once(|| {
                        tracing::warn!(
                            target: "derp_shell_dmabuf",
                            width,
                            height,
                            exp_w,
                            exp_h,
                            logical_w = lw,
                            logical_h = lh,
                            "shell dma-buf is smaller than canvas physical size â€” Solid is being upscaled (soft)."
                        );
                    });
                }
            }
        }
        Ok(ShellFrameApply {
            commit: self.shell_dmabuf_commit,
        })
    }

    pub(crate) fn apply_shell_frame_software(
        &mut self,
        width: u32,
        height: u32,
        pixels: Vec<u8>,
        dirty_buffer: Option<Vec<(i32, i32, i32, i32)>>,
        workspace_ready: bool,
    ) -> Result<ShellFrameApply, &'static str> {
        if width == 0 || height == 0 {
            return Err("bad dimensions");
        }
        let need = (width as usize)
            .checked_mul(height as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or("software frame too large")?;
        if pixels.len() < need {
            return Err("software frame buffer too small");
        }
        if !self.frame_size_matches_expected(width, height, workspace_ready) {
            self.shell_nudge_cef_repaint();
            tracing::debug!(
                target: "derp_hotplug_shell",
                width,
                height,
                "apply_shell_frame_software reject mismatched size pending CEF resize paint"
            );
            return Err("software frame size mismatch shell_window_physical_px");
        }
        let resized = self.shell_view_px.is_some_and(|p| p != (width, height));
        let (force_full, force_env, pending_force_full, bbox_full, dirty_supplied_len) =
            self.prepare_frame_damage(width, height, dirty_buffer);
        self.shell_dmabuf_commit.increment();
        self.shell_frame_sequence = self.shell_frame_sequence.wrapping_add(1);
        self.shell_dmabuf = None;
        self.shell_software_frame = Some(pixels);
        self.shell_frame_is_dmabuf = false;
        self.shell_has_frame = true;
        self.shell_view_px = Some((width, height));
        self.sync_osr_physical_from_frame(width, height);
        if resized {
            tracing::warn!(
                target: "derp_hotplug_shell",
                width,
                height,
                "apply_shell_frame_software OSR size changed shell_has_frame true"
            );
        }
        tracing::debug!(
            target: "derp_shell_osr_damage",
            width,
            height,
            force_full,
            force_env,
            pending_force_full,
            resized,
            dirty_supplied = dirty_supplied_len,
            bbox_full,
            partial_rects = self.shell_dmabuf_dirty_buffer.len(),
            commit = ?self.shell_dmabuf_commit,
            "apply_shell_frame_software damage"
        );
        Ok(ShellFrameApply {
            commit: self.shell_dmabuf_commit,
        })
    }

    pub(crate) fn sync_osr_physical_from_frame(&self, width: u32, height: u32) {
        if let Ok(g) = self.shell_to_cef.lock() {
            if let Some(link) = g.as_ref() {
                link.sync_osr_physical_from_dmabuf(width as i32, height as i32);
            }
        }
    }

    pub(crate) fn clear_shell_frame(&mut self) {
        tracing::warn!(target: "derp_hotplug_shell", "clear_shell_frame");
        self.shell_has_frame = false;
        self.shell_view_px = None;
        self.shell_frame_is_dmabuf = false;
        self.shell_dmabuf = None;
        self.shell_software_frame = None;
        self.shell_software_generation = 0;
        self.shell_dmabuf_generation = 0;
        self.shell_dmabuf_overlay_id = Id::new();
        self.shell_dmabuf_commit = CommitCounter::default();
        self.shell_frame_sequence = 0;
        self.shell_dmabuf_dirty_buffer.clear();
        self.shell_dmabuf_dirty_force_full = true;
        self.shell_dmabuf_next_force_full = false;
        if self.pending_shell_ui_windows.take().is_some() {
            crate::cef::begin_frame_diag::note_shell_ui_windows_pending_dropped();
        }
    }
}
