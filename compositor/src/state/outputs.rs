use super::*;

pub const SHELL_TITLEBAR_HEIGHT: i32 = 26;
pub const SHELL_TASKBAR_RESERVE_PX: i32 = 36;

pub(crate) struct OutputTopologyState {
    pub(crate) space: Space<DerpSpaceElem>,
    #[allow(dead_code)]
    pub(crate) output_manager_state: OutputManagerState,
    pub(crate) shell_primary_output_name: Option<String>,
    pub(crate) taskbar_auto_hide: bool,
    pub(crate) taskbar_side_by_output_name: HashMap<String, ShellTaskbarSide>,
    pub(crate) output_vrr_by_name: HashMap<String, (bool, bool)>,
    pub(crate) output_flip_state_by_name: HashMap<String, (String, Option<String>)>,
    pub(crate) display_config_save_pending: bool,
    pub(crate) display_config_save_suppressed: bool,
    pub(crate) shell_output_topology_revision: u64,
    pub(crate) shell_canvas_logical_origin: (i32, i32),
    pub(crate) shell_canvas_logical_size: (u32, u32),
    pub(crate) shell_ui_scale: f64,
}

pub(crate) struct ShellCanvasRecompute {
    pub(crate) prev_origin: (i32, i32),
    pub(crate) prev_size: (u32, u32),
    pub(crate) origin: (i32, i32),
    pub(crate) size: (u32, u32),
    pub(crate) physical_px: (i32, i32),
    pub(crate) changed: bool,
}

pub(crate) enum OutputTopologyMutation {
    Unchanged,
    ChangedSuppressed,
    ChangedNeedsSave,
}

impl OutputTopologyMutation {
    pub(crate) fn needs_side_effects(&self) -> bool {
        matches!(self, Self::ChangedNeedsSave)
    }
}

#[derive(serde::Deserialize)]
struct ShellOutputLayoutScreenInput {
    name: String,
    x: i32,
    y: i32,
    #[serde(default)]
    transform: u32,
}

#[derive(serde::Deserialize)]
struct ShellOutputLayoutInput {
    screens: Vec<ShellOutputLayoutScreenInput>,
}

impl OutputTopologyState {
    pub(crate) fn next_shell_output_topology_revision(&mut self) -> u64 {
        self.shell_output_topology_revision = self.shell_output_topology_revision.wrapping_add(1);
        self.shell_output_topology_revision
    }

    pub(crate) fn workspace_logical_bounds(&self) -> Option<Rectangle<i32, Logical>> {
        let mut min_x = i32::MAX;
        let mut min_y = i32::MAX;
        let mut max_x = i32::MIN;
        let mut max_y = i32::MIN;
        for o in self.space.outputs() {
            let g = self.space.output_geometry(o)?;
            min_x = min_x.min(g.loc.x);
            min_y = min_y.min(g.loc.y);
            max_x = max_x.max(g.loc.x.saturating_add(g.size.w));
            max_y = max_y.max(g.loc.y.saturating_add(g.size.h));
        }
        if min_x == i32::MAX {
            return None;
        }
        Some(Rectangle::new(
            Point::<i32, Logical>::from((min_x, min_y)),
            Size::<i32, Logical>::from(((max_x - min_x).max(1), (max_y - min_y).max(1))),
        ))
    }

    pub(crate) fn wayland_scale_for_shell_ui(shell_ui_scale: f64) -> Scale {
        if (shell_ui_scale - 1.0).abs() < f64::EPSILON {
            return Scale::Integer(1);
        }
        if shell_ui_scale.fract().abs() < f64::EPSILON {
            return Scale::Integer(shell_ui_scale.round() as i32);
        }
        Scale::Fractional(shell_ui_scale)
    }

    pub(crate) fn apply_shell_ui_scale_to_outputs(&mut self) {
        let outs: Vec<Output> = self.space.outputs().cloned().collect();
        let sc = Self::wayland_scale_for_shell_ui(self.shell_ui_scale);
        for out in outs {
            let Some(mode) = out.current_mode() else {
                continue;
            };
            let tf = out.current_transform();
            let Some(g) = self.space.output_geometry(&out) else {
                continue;
            };
            let loc = g.loc;
            out.change_current_state(Some(mode), Some(tf), Some(sc), Some(loc.into()));
            self.space.map_output(&out, (loc.x, loc.y));
        }
    }

    pub(crate) fn set_shell_ui_scale(&mut self, scale: f64) -> bool {
        if (scale - 1.0).abs() > f64::EPSILON
            && (scale - 1.5).abs() > f64::EPSILON
            && (scale - 2.0).abs() > f64::EPSILON
        {
            return false;
        }
        self.shell_ui_scale = scale;
        self.apply_shell_ui_scale_to_outputs();
        true
    }

    pub(crate) fn display_config_request_save(&mut self) {
        if !self.display_config_save_suppressed {
            self.display_config_save_pending = true;
        }
    }

    pub(crate) fn normalize_workspace_to_origin_after_output_removed(
        &mut self,
    ) -> Vec<(DerpSpaceElem, i32, i32)> {
        let Some(ws) = self.workspace_logical_bounds() else {
            return Vec::new();
        };
        let dx = -ws.loc.x;
        let dy = -ws.loc.y;
        self.translate_workspace_by(dx, dy)
    }

    pub(crate) fn translate_workspace_by(
        &mut self,
        dx: i32,
        dy: i32,
    ) -> Vec<(DerpSpaceElem, i32, i32)> {
        if dx == 0 && dy == 0 {
            return Vec::new();
        }
        let elem_targets: Vec<(DerpSpaceElem, i32, i32)> = self.space
            .elements()
            .filter_map(|e| {
                let loc = self.space.element_location(e)?;
                Some((
                    e.clone(),
                    loc.x.saturating_add(dx),
                    loc.y.saturating_add(dy),
                ))
            })
            .collect();
        let outs: Vec<Output> = self.space.outputs().cloned().collect();
        let sc = Self::wayland_scale_for_shell_ui(self.shell_ui_scale);
        for out in outs.iter() {
            let Some(g) = self.space.output_geometry(out) else {
                continue;
            };
            let Some(mode) = out.current_mode() else {
                continue;
            };
            let tf = out.current_transform();
            let nx = g.loc.x.saturating_add(dx);
            let ny = g.loc.y.saturating_add(dy);
            out.change_current_state(Some(mode), Some(tf), Some(sc), Some((nx, ny).into()));
            self.space.map_output(out, (nx, ny));
        }
        elem_targets
    }

    pub(crate) fn recompute_shell_canvas_from_outputs(
        &mut self,
        prev_physical_px: (i32, i32),
    ) -> Option<ShellCanvasRecompute> {
        let prev_origin = self.shell_canvas_logical_origin;
        let prev_size = self.shell_canvas_logical_size;
        let Some(bounds) = self.workspace_logical_bounds() else {
            return None;
        };
        let cw = bounds.size.w.max(1) as u32;
        let ch_work = bounds.size.h.max(1) as u32;
        self.shell_canvas_logical_origin = (bounds.loc.x, bounds.loc.y);
        let mut max_scale = 1.0f64;
        for o in self.space.outputs() {
            max_scale = max_scale.max(o.current_scale().fractional_scale() as f64);
        }
        let ch_canvas = ch_work.max(1);
        self.shell_canvas_logical_size = (cw, ch_canvas);
        let pw = ((cw as f64) * max_scale).round().max(1.0) as i32;
        let ph = ((ch_work as f64) * max_scale).round().max(1.0) as i32;
        let physical_px = (pw, ph);
        Some(ShellCanvasRecompute {
            prev_origin,
            prev_size,
            origin: self.shell_canvas_logical_origin,
            size: self.shell_canvas_logical_size,
            physical_px,
            changed: prev_origin != self.shell_canvas_logical_origin
                || prev_size != self.shell_canvas_logical_size
                || prev_physical_px != physical_px,
        })
    }

    pub(crate) fn leftmost_output(&self) -> Option<Output> {
        self.space
            .outputs()
            .min_by_key(|o| {
                self.space
                    .output_geometry(o)
                    .map(|g| g.loc.x)
                    .unwrap_or(i32::MAX)
            })
            .cloned()
    }

    pub(crate) fn output_containing_global_point(&self, p: Point<f64, Logical>) -> Option<Output> {
        let ix = p.x.floor() as i32;
        let iy = p.y.floor() as i32;
        for o in self.space.outputs() {
            let g = self.space.output_geometry(o)?;
            if ix >= g.loc.x
                && iy >= g.loc.y
                && ix < g.loc.x.saturating_add(g.size.w)
                && iy < g.loc.y.saturating_add(g.size.h)
            {
                return Some(o.clone());
            }
        }
        None
    }

    pub(crate) fn output_for_global_xywh(&self, x: i32, y: i32, w: i32, h: i32) -> Option<Output> {
        let picked = self.output_for_window_position(x, y, w, h)?;
        self.space
            .outputs()
            .find(|o| o.name() == picked.as_str())
            .cloned()
            .or_else(|| self.leftmost_output())
    }

    pub(crate) fn output_for_window_position(
        &self,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    ) -> Option<String> {
        let pairs: Vec<(String, Rectangle<i32, Logical>)> = self.space
            .outputs()
            .filter_map(|o| {
                let g = self.space.output_geometry(o)?;
                Some((o.name().into(), g))
            })
            .collect();
        if pairs.is_empty() {
            return self.space.outputs().next().map(|o| o.name().into());
        }
        pick_output_name_for_global_window_rect_from_output_rects(&pairs, x, y, w, h)
    }

    pub(crate) fn snapshot_output_geometry_by_name(
        &self,
    ) -> HashMap<String, Rectangle<i32, Logical>> {
        let mut m = HashMap::new();
        for o in self.space.outputs() {
            if let Some(g) = self.space.output_geometry(o) {
                m.insert(o.name().into(), g);
            }
        }
        m
    }

    pub(crate) fn output_name_for_window_from_geometry_map(
        geos: &HashMap<String, Rectangle<i32, Logical>>,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    ) -> Option<String> {
        if geos.is_empty() {
            return None;
        }
        let pairs: Vec<(String, Rectangle<i32, Logical>)> =
            geos.iter().map(|(n, g)| (n.clone(), *g)).collect();
        pick_output_name_for_global_window_rect_from_output_rects(&pairs, x, y, w, h)
    }

    pub(crate) fn pick_nearest_surviving_output(&self, remove: &Output) -> Option<Output> {
        let removed_name = remove.name();
        let rg = self.space.output_geometry(remove)?;
        let rcx = rg.loc.x.saturating_add(rg.size.w.saturating_div(2));
        let rcy = rg.loc.y.saturating_add(rg.size.h.saturating_div(2));
        let mut scored: Vec<(i32, i32, Output)> = self.space
            .outputs()
            .filter(|o| o.name() != removed_name)
            .filter_map(|o| {
                let g = self.space.output_geometry(o)?;
                let cx = g.loc.x.saturating_add(g.size.w.saturating_div(2));
                let cy = g.loc.y.saturating_add(g.size.h.saturating_div(2));
                Some(((cx - rcx).abs(), (cy - rcy).abs(), o.clone()))
            })
            .collect();
        if scored.is_empty() {
            return None;
        }
        scored.sort_by_key(|(dx, dy, _)| (*dx, *dy));
        let (best_dx, best_dy, _) = scored[0];
        let tier: Vec<Output> = scored
            .into_iter()
            .filter(|(dx, dy, _)| *dx == best_dx && *dy == best_dy)
            .map(|(_, _, o)| o)
            .collect();
        if tier.len() == 1 {
            return tier.into_iter().next();
        }
        if let Some(pref) = self.shell_effective_primary_output() {
            let pn = pref.name();
            if let Some(o) = tier.iter().find(|o| o.name() == pn) {
                return Some(o.clone());
            }
        }
        tier.into_iter().next()
    }

    pub(crate) fn shell_effective_primary_output(&self) -> Option<Output> {
        if let Some(ref name) = self.shell_primary_output_name {
            if let Some(o) = self
                .space
                .outputs()
                .find(|o| o.name() == name.as_str())
                .cloned()
            {
                return Some(o);
            }
        }
        self.leftmost_output()
    }

    pub(crate) fn shell_clear_stale_primary_output(&mut self) -> bool {
        if let Some(ref n) = self.shell_primary_output_name {
            if !self.space.outputs().any(|o| o.name() == n.as_str()) {
                self.shell_primary_output_name = None;
                return true;
            }
        }
        false
    }

    pub(crate) fn shell_output_layout_message_with_revision(
        &mut self,
        bump_revision: bool,
        shell_window_physical_px: (i32, i32),
    ) -> Option<shell_wire::DecodedCompositorToShellMessage> {
        self.workspace_logical_bounds()?;
        let revision = if bump_revision {
            self.next_shell_output_topology_revision()
        } else {
            self.shell_output_topology_revision
        };
        let (lw, lh) = self.shell_canvas_logical_size;
        let (pw, ph) = shell_window_physical_px;
        let physical_w = u32::try_from(pw).unwrap_or(lw).max(1);
        let physical_h = u32::try_from(ph).unwrap_or(lh).max(1);
        let screens: Vec<shell_wire::OutputLayoutScreen> = self.space
            .outputs()
            .filter_map(|o| {
                let g = self.space.output_geometry(o)?;
                let tf = o.current_transform();
                let mode = o.current_mode()?;
                let refresh_milli_hz = u32::try_from(mode.refresh.max(1)).unwrap_or(1);
                let (vrr_supported, vrr_enabled) = self.output_vrr_state(o.name().as_str());
                let taskbar_side = self.taskbar_side_for_output_name(o.name().as_str());
                Some(shell_wire::OutputLayoutScreen {
                    name: o.name(),
                    identity: Self::shell_output_identity(o),
                    x: g.loc.x,
                    y: g.loc.y,
                    w: u32::try_from(g.size.w).ok()?.max(1),
                    h: u32::try_from(g.size.h).ok()?.max(1),
                    physical_w: u32::try_from(mode.size.w).ok()?.max(1),
                    physical_h: u32::try_from(mode.size.h).ok()?.max(1),
                    transform: transform_to_wire(tf),
                    refresh_milli_hz,
                    vrr_supported,
                    vrr_enabled,
                    taskbar_side: taskbar_side.to_wire(),
                })
            })
            .collect();
        Some(shell_wire::DecodedCompositorToShellMessage::OutputLayout {
            revision,
            canvas_logical_w: lw.max(1),
            canvas_logical_h: lh.max(1),
            canvas_physical_w: physical_w,
            canvas_physical_h: physical_h,
            screens,
            shell_chrome_primary: self.shell_primary_output_name.clone(),
            taskbar_auto_hide: self.taskbar_auto_hide,
        })
    }

    pub(crate) fn shell_output_identity(output: &Output) -> String {
        let props = output.physical_properties();
        let mut parts = Vec::new();
        for part in [
            props.make.as_str(),
            props.model.as_str(),
            props.serial_number.as_str(),
        ] {
            let part = part.trim();
            if !part.is_empty() && part != "N/A" {
                parts.push(part.to_string());
            }
        }
        parts.push(format!("{}x{}", props.size.w.max(1), props.size.h.max(1)));
        let mut identity = parts.join(":");
        if identity.is_empty() {
            identity = output.name();
        }
        while identity.len() > shell_wire::MAX_OUTPUT_LAYOUT_NAME_BYTES as usize {
            identity.pop();
        }
        identity
    }

    pub(crate) fn workspace_output_identity_for_name(&self, output_name: &str) -> Option<String> {
        self.space
            .outputs()
            .find(|output| output.name() == output_name)
            .map(Self::shell_output_identity)
    }

    pub(crate) fn set_output_vrr_states<I>(&mut self, states: I)
    where
        I: IntoIterator<Item = (String, bool, bool)>,
    {
        self.output_vrr_by_name = states
            .into_iter()
            .map(|(name, supported, enabled)| (name, (supported, supported && enabled)))
            .collect();
    }

    pub(crate) fn set_output_vrr_state(&mut self, name: String, supported: bool, enabled: bool) {
        self.output_vrr_by_name
            .insert(name, (supported, supported && enabled));
    }

    pub(crate) fn output_vrr_state(&self, name: &str) -> (bool, bool) {
        self.output_vrr_by_name
            .get(name)
            .copied()
            .unwrap_or((false, false))
    }

    pub(crate) fn set_output_flip_state(
        &mut self,
        name: String,
        mode: impl Into<String>,
        fallback_reason: Option<String>,
    ) {
        self.output_flip_state_by_name
            .insert(name, (mode.into(), fallback_reason));
    }

    pub(crate) fn output_flip_state(&self, name: &str) -> (String, Option<String>) {
        self.output_flip_state_by_name
            .get(name)
            .cloned()
            .unwrap_or_else(|| ("vsync".to_string(), None))
    }

    pub(crate) fn taskbar_side_for_output_name(&self, name: &str) -> ShellTaskbarSide {
        self.taskbar_side_by_output_name
            .get(name)
            .copied()
            .unwrap_or_default()
    }

    pub(crate) fn set_taskbar_auto_hide(&mut self, enabled: bool) -> OutputTopologyMutation {
        if self.taskbar_auto_hide == enabled {
            return OutputTopologyMutation::Unchanged;
        }
        self.taskbar_auto_hide = enabled;
        if self.display_config_save_suppressed {
            OutputTopologyMutation::ChangedSuppressed
        } else {
            OutputTopologyMutation::ChangedNeedsSave
        }
    }

    pub(crate) fn set_taskbar_side(
        &mut self,
        output_name: String,
        side: ShellTaskbarSide,
    ) -> OutputTopologyMutation {
        if !self.space.outputs().any(|o| o.name() == output_name.as_str()) {
            return OutputTopologyMutation::Unchanged;
        }
        if side == ShellTaskbarSide::Bottom {
            if self.taskbar_side_by_output_name.remove(&output_name).is_none() {
                return OutputTopologyMutation::Unchanged;
            }
        } else if self.taskbar_side_by_output_name.get(&output_name).copied() == Some(side) {
            return OutputTopologyMutation::Unchanged;
        } else {
            self.taskbar_side_by_output_name.insert(output_name, side);
        }
        if self.display_config_save_suppressed {
            OutputTopologyMutation::ChangedSuppressed
        } else {
            OutputTopologyMutation::ChangedNeedsSave
        }
    }

    pub(crate) fn set_shell_primary_output_name(
        &mut self,
        name: String,
    ) -> OutputTopologyMutation {
        let pref = if name.is_empty() {
            None
        } else {
            if !self.space.outputs().any(|o| o.name() == name.as_str()) {
                return OutputTopologyMutation::Unchanged;
            }
            Some(name)
        };
        self.shell_primary_output_name = pref;
        if self.display_config_save_suppressed {
            OutputTopologyMutation::ChangedSuppressed
        } else {
            OutputTopologyMutation::ChangedNeedsSave
        }
    }

    pub(crate) fn apply_shell_output_layout_json(
        &mut self,
        json: &str,
    ) -> Option<HashMap<String, Rectangle<i32, Logical>>> {
        let Ok(root) = serde_json::from_str::<ShellOutputLayoutInput>(json) else {
            return None;
        };
        let before_outputs = self.snapshot_output_geometry_by_name();
        let mut resolved: Vec<(ShellOutputLayoutScreenInput, Output)> = Vec::new();
        for s in root.screens {
            let Some(out) = self.space.outputs().find(|o| o.name() == s.name).cloned() else {
                continue;
            };
            if out.current_mode().is_none() {
                continue;
            }
            resolved.push((s, out));
        }
        let sc = Self::wayland_scale_for_shell_ui(self.shell_ui_scale);
        for (s, out) in &resolved {
            let mode = out.current_mode().unwrap();
            let tf = transform_from_wire(s.transform);
            out.change_current_state(Some(mode), Some(tf), Some(sc), Some((s.x, s.y).into()));
            self.space.map_output(out, (s.x, s.y));
        }
        let mut row_buckets: HashMap<i32, Vec<usize>> = HashMap::new();
        for (i, (s, _)) in resolved.iter().enumerate() {
            row_buckets.entry(s.y).or_default().push(i);
        }
        let mut new_xy: Vec<(i32, i32)> = resolved.iter().map(|(s, _)| (s.x, s.y)).collect();
        for mut indices in row_buckets.into_values() {
            indices.sort_by_key(|&i| resolved[i].0.x);
            let mut cx = resolved[indices[0]].0.x;
            for &i in &indices {
                let (s, out) = &resolved[i];
                let w = self
                    .space
                    .output_geometry(out)
                    .map(|g| g.size.w)
                    .unwrap_or(0)
                    .max(0);
                new_xy[i] = (cx, s.y);
                cx += w;
            }
        }
        for (i, (s, out)) in resolved.iter().enumerate() {
            let (nx, ny) = new_xy[i];
            let Some(mode) = out.current_mode() else {
                continue;
            };
            let tf = transform_from_wire(s.transform);
            out.change_current_state(Some(mode), Some(tf), Some(sc), Some((nx, ny).into()));
            self.space.map_output(out, (nx, ny));
        }
        self.shell_clear_stale_primary_output();
        Some(before_outputs)
    }

    pub(crate) fn shell_output_logical_size(&self) -> Option<(u32, u32)> {
        let b = self.workspace_logical_bounds()?;
        Some((
            u32::try_from(b.size.w).ok()?.max(1),
            u32::try_from(b.size.h).ok()?.max(1),
        ))
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShellTaskbarSide {
    Bottom,
    Top,
    Left,
    Right,
}

impl Default for ShellTaskbarSide {
    fn default() -> Self {
        Self::Bottom
    }
}

impl ShellTaskbarSide {
    pub(crate) fn from_str(value: &str) -> Option<Self> {
        match value {
            "bottom" => Some(Self::Bottom),
            "top" => Some(Self::Top),
            "left" => Some(Self::Left),
            "right" => Some(Self::Right),
            _ => None,
        }
    }

    pub(crate) fn to_wire(self) -> u32 {
        match self {
            Self::Bottom => shell_wire::TASKBAR_SIDE_BOTTOM,
            Self::Top => shell_wire::TASKBAR_SIDE_TOP,
            Self::Left => shell_wire::TASKBAR_SIDE_LEFT,
            Self::Right => shell_wire::TASKBAR_SIDE_RIGHT,
        }
    }
}

pub(super) fn apply_taskbar_reserve_to_global_rect(
    rect: Rectangle<i32, Logical>,
    side: ShellTaskbarSide,
    reserve: i32,
) -> Rectangle<i32, Logical> {
    let tb = reserve.max(0);
    let (x, y, w, h) = match side {
        ShellTaskbarSide::Bottom => (
            rect.loc.x,
            rect.loc.y,
            rect.size.w.max(1),
            rect.size.h.saturating_sub(tb).max(1),
        ),
        ShellTaskbarSide::Top => (
            rect.loc.x,
            rect.loc.y.saturating_add(tb),
            rect.size.w.max(1),
            rect.size.h.saturating_sub(tb).max(1),
        ),
        ShellTaskbarSide::Left => (
            rect.loc.x.saturating_add(tb),
            rect.loc.y,
            rect.size.w.saturating_sub(tb).max(1),
            rect.size.h.max(1),
        ),
        ShellTaskbarSide::Right => (
            rect.loc.x,
            rect.loc.y,
            rect.size.w.saturating_sub(tb).max(1),
            rect.size.h.max(1),
        ),
    };
    Rectangle::new(Point::from((x, y)), Size::from((w, h)))
}
