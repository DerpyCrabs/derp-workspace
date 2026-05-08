use super::*;

impl CompositorState {
    pub(crate) fn derp_elem_window_id(&self, elem: &DerpSpaceElem) -> Option<u32> {
        self.windows.derp_elem_window_id(elem)
    }

    pub(super) fn workspace_window_is_logically_visible(&self, window_id: u32) -> bool {
        self.workspace_layout
            .workspace_window_is_logically_visible(&self.windows.window_registry, window_id)
    }

    pub(crate) fn workspace_window_is_visible_during_render(&self, window_id: u32) -> bool {
        self.workspace_window_is_logically_visible(window_id)
    }

    pub(crate) fn workspace_window_render_alpha(&self, window_id: u32) -> f32 {
        WorkspaceLayoutState::workspace_window_render_alpha(
            self.input_routing.shell_move_window_id,
            window_id,
        )
    }

    pub(crate) fn workspace_window_is_tiled(&self, window_id: u32) -> bool {
        self.workspace_layout.workspace_window_is_tiled(window_id)
    }

    pub(crate) fn shell_native_outer_global_rect(
        &self,
        info: &WindowInfo,
    ) -> Rectangle<i32, Logical> {
        let th = self.shell_osr.shell_chrome_titlebar_h.max(0);
        let bd = self.shell_osr.shell_chrome_border_w.max(0);
        let suppress_side_strips =
            info.maximized || info.fullscreen || self.workspace_window_is_tiled(info.window_id);
        let inset = if suppress_side_strips { 0 } else { bd };
        let inset_top = if suppress_side_strips {
            0
        } else {
            SHELL_BORDER_TOP_THICKNESS
        };
        let x = info.x.saturating_sub(inset);
        let y = info.y.saturating_sub(th.saturating_add(inset_top));
        let w = info.width.max(1).saturating_add(inset.saturating_mul(2));
        let h = info
            .height
            .max(1)
            .saturating_add(th)
            .saturating_add(inset_top)
            .saturating_add(inset);
        Rectangle::new(Point::from((x, y)), Size::from((w.max(1), h.max(1))))
    }

    pub(crate) fn ordered_window_ids_on_output(&self, output: &Output) -> Vec<u32> {
        let visible_window_ids_on_output: HashSet<u32> = self
            .output_topology
            .space
            .elements_for_output(output)
            .filter_map(|e| self.derp_elem_window_id(e))
            .filter(|window_id| self.workspace_window_is_visible_during_render(*window_id))
            .collect();
        self.shell_window_stack_ids()
            .into_iter()
            .filter(|window_id| visible_window_ids_on_output.contains(window_id))
            .collect()
    }

    pub(crate) fn output_has_fullscreen_native_direct_path(&self, output: &Output) -> bool {
        if self.shell_osr.shell_presentation_fullscreen
            || self.shell_osr.shell_exclusion_overlay_open
            || self.capture.has_screenshot_request()
            || self.capture.screenshot_selection_active()
            || self.workspace_layout.tile_preview_rect_global.is_some()
            || self.input_routing.shell_move_window_id.is_some()
            || !self.shell_osr.shell_ui_windows.is_empty()
            || !self.shell_osr.shell_exclusion_floating.is_empty()
        {
            return false;
        }
        let Some(output_geo) = self.output_topology.space.output_geometry(output) else {
            return false;
        };
        let Some(layer_usable) = self
            .output_topology
            .layer_usable_area_global_for_output(output)
        else {
            return false;
        };
        if layer_usable != output_geo {
            return false;
        }
        let Some(window_id) = self.ordered_window_ids_on_output(output).last().copied() else {
            return false;
        };
        if self.windows.window_registry.is_shell_hosted(window_id) {
            return false;
        }
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return false;
        };
        if !info.fullscreen
            || info.minimized
            || self.window_info_is_solid_shell_host(&info)
            || self.workspace_window_render_alpha(window_id) < 0.999
        {
            return false;
        }
        let rect = Rectangle::new(
            Point::from((info.x, info.y)),
            Size::from((info.width.max(1), info.height.max(1))),
        );
        rect.contains(output_geo.loc)
            && rect.contains(Point::from((
                output_geo
                    .loc
                    .x
                    .saturating_add(output_geo.size.w.saturating_sub(1)),
                output_geo
                    .loc
                    .y
                    .saturating_add(output_geo.size.h.saturating_sub(1)),
            )))
    }

    pub(crate) fn output_async_tearing_candidate_window(&self, output: &Output) -> Option<u32> {
        if !self.output_has_fullscreen_native_direct_path(output) {
            return None;
        }
        let window_id = self.ordered_window_ids_on_output(output).last().copied()?;
        (self.tearing_hint_for_window_id(window_id) == TearingPresentationHint::Async)
            .then_some(window_id)
    }

    pub(super) fn window_ids_strictly_above_in_stack<'a>(
        &self,
        ordered_window_ids: &'a [u32],
        self_id: u32,
    ) -> &'a [u32] {
        let Some(idx) = ordered_window_ids.iter().position(|id| *id == self_id) else {
            return &[];
        };
        &ordered_window_ids[(idx + 1)..]
    }

    pub(super) fn shell_decoration_clip_rects_for_window(
        &self,
        window_id: u32,
    ) -> Vec<Rectangle<i32, Logical>> {
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return Vec::new();
        };
        if info.minimized || !self.workspace_window_is_visible_during_render(window_id) {
            return Vec::new();
        }
        let is_shell_hosted = self.windows.window_registry.is_shell_hosted(window_id);
        if !is_shell_hosted
            && self.windows.window_registry.window_kind(window_id) != Some(WindowKind::Native)
        {
            return Vec::new();
        }
        let outer = if is_shell_hosted {
            self.shell_backed_outer_global_rect(&info)
        } else {
            self.shell_native_outer_global_rect(&info)
        };
        let titlebar_h = self.shell_osr.shell_chrome_titlebar_h.max(0);
        if titlebar_h <= 0 {
            return Vec::new();
        }
        let no_outer_border = info.maximized || info.fullscreen;
        let border = if no_outer_border {
            0
        } else {
            self.shell_osr.shell_chrome_border_w.max(0)
        };
        let inset_top = if no_outer_border {
            0
        } else {
            SHELL_BORDER_TOP_THICKNESS
        };
        let mut out = vec![Rectangle::new(
            outer.loc,
            Size::from((
                outer.size.w.max(1),
                titlebar_h
                    .saturating_add(inset_top)
                    .saturating_add(if info.client_side_decoration { 1 } else { 0 }),
            )),
        )];
        if border > 0 {
            let client = Self::shell_hosted_client_global_rect(&info);
            out.push(Rectangle::new(
                Point::from((outer.loc.x, client.loc.y)),
                Size::from((border, client.size.h.max(1))),
            ));
            out.push(Rectangle::new(
                Point::from((client.loc.x.saturating_add(client.size.w), client.loc.y)),
                Size::from((border, client.size.h.max(1))),
            ));
            out.push(Rectangle::new(
                Point::from((outer.loc.x, client.loc.y.saturating_add(client.size.h))),
                Size::from((outer.size.w.max(1), border)),
            ));
        }
        out
    }

    pub(crate) fn shell_exclusion_clip_rects_logical(
        &self,
        output: &Output,
        elem_window: Option<u32>,
        include_self_decor: bool,
        ordered_window_ids_on_output: Option<&[u32]>,
    ) -> Vec<Rectangle<i32, Logical>> {
        let Some(ws) = self.workspace_logical_bounds() else {
            return Vec::new();
        };
        let Some(out_geo) = self.output_topology.space.output_geometry(output) else {
            return Vec::new();
        };
        let Some(visible) = ws.intersection(out_geo) else {
            return Vec::new();
        };
        let mut out: Vec<Rectangle<i32, Logical>> = self
            .shell_osr
            .shell_exclusion_global
            .iter()
            .filter_map(|z| z.intersection(visible))
            .collect();
        out.extend(
            self.shell_osr
                .shell_exclusion_floating
                .iter()
                .filter_map(|z| z.intersection(visible)),
        );
        if let Some(rect) = self
            .shell_native_drag_preview_clip_rect()
            .and_then(|rect| rect.intersection(visible))
        {
            out.push(rect);
        }
        let placements = self.shell_hosted_clip_placements(elem_window);
        match elem_window {
            None => {
                for placement in &self.shell_osr.shell_ui_windows {
                    for r in self.shell_decoration_clip_rects_for_window(placement.id) {
                        if let Some(i) = r.intersection(visible) {
                            out.push(i);
                        }
                    }
                }
            }
            Some(self_id) => {
                let ordered_window_ids_on_output_owned;
                let ordered_window_ids_on_output = if let Some(ordered) =
                    ordered_window_ids_on_output
                {
                    ordered
                } else {
                    ordered_window_ids_on_output_owned = self.ordered_window_ids_on_output(output);
                    &ordered_window_ids_on_output_owned
                };
                for &ow in
                    self.window_ids_strictly_above_in_stack(ordered_window_ids_on_output, self_id)
                {
                    for r in self.shell_decoration_clip_rects_for_window(ow) {
                        if let Some(i) = r.intersection(visible) {
                            out.push(i);
                        }
                    }
                }
                if include_self_decor {
                    for r in self.shell_decoration_clip_rects_for_window(self_id) {
                        if let Some(i) = r.intersection(visible) {
                            out.push(i);
                        }
                    }
                }
            }
        }
        for w in &placements {
            if let Some(i) = w.global_rect.intersection(visible) {
                out.push(i);
            }
        }
        out
    }

    pub(crate) fn shell_exclusion_clip_ctx_for_draw(
        &self,
        output: &Output,
        elem_window: Option<u32>,
        include_self_decor: bool,
        ordered_window_ids_on_output: Option<&[u32]>,
    ) -> Option<Arc<exclusion_clip::ShellExclusionClipCtx>> {
        let zones = self.shell_exclusion_clip_rects_logical(
            output,
            elem_window,
            include_self_decor,
            ordered_window_ids_on_output,
        );
        if zones.is_empty() {
            return None;
        }
        let Some(out_geo) = self.output_topology.space.output_geometry(output) else {
            return None;
        };
        let Some(ws) = self.workspace_logical_bounds() else {
            return None;
        };
        let Some(visible) = ws.intersection(out_geo) else {
            return None;
        };
        let filtered: Vec<Rectangle<i32, Logical>> = zones
            .iter()
            .filter_map(|z| z.intersection(visible))
            .collect();
        if filtered.is_empty() {
            return None;
        }
        Some(Arc::new(exclusion_clip::ShellExclusionClipCtx {
            zones: Arc::from(filtered.into_boxed_slice()),
            output_logical: Rectangle::new(out_geo.loc, out_geo.size),
            scale_f: output.current_scale().fractional_scale(),
        }))
    }
}
