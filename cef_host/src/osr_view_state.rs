//! OSR view / buffer sizes and compositor (**buffer** px) → CEF (**DIP**) mapping.

use std::time::{Duration, Instant};

/// Placeholder DIP before the compositor sends [`shell_wire::MSG_OUTPUT_GEOMETRY`].
pub const OSR_BOOTSTRAP_DIP_W: i32 = 800;
pub const OSR_BOOTSTRAP_DIP_H: i32 = 600;

/// DIP (CSS / “view”) size of the browser plus last OSR paint dimensions.
///
/// CEF [`send_mouse_move_event`](cef::ImplBrowserHost::send_mouse_move_event) expects coordinates
/// in **view** space, while `on_paint` buffer sizes are **device** pixels
/// (`view * device_scale_factor`). The compositor maps pointer position into **buffer** pixels
/// (same space as the BGRA frame); we convert to view pixels here.
#[derive(Debug, Clone)]
pub struct OsrViewState {
    /// DIP / CSS width (matches CEF view and `WindowInfo::bounds`).
    pub dip_w: i32,
    /// DIP / CSS height.
    pub dip_h: i32,
    buffer_w: i32,
    buffer_h: i32,
    /// Expected OSR bitmap size from compositor (physical output pixels); undersized paints trigger a nudge.
    target_buf_w: i32,
    target_buf_h: i32,
    /// Last time we nudged CEF after an undersized OSR paint (stuck low-res upscale in the compositor).
    last_undersized_nudge: Option<Instant>,
}

impl OsrViewState {
    pub fn new(dip_w: i32, dip_h: i32) -> Self {
        Self {
            dip_w,
            dip_h,
            buffer_w: dip_w,
            buffer_h: dip_h,
            target_buf_w: dip_w,
            target_buf_h: dip_h,
            last_undersized_nudge: None,
        }
    }

    /// Initial state before the compositor sends `OutputGeometry` (logical size → DIP).
    pub fn new_bootstrap() -> Self {
        Self::new(OSR_BOOTSTRAP_DIP_W, OSR_BOOTSTRAP_DIP_H)
    }

    pub fn set_target_buffer(&mut self, w: i32, h: i32) {
        if w > 0 && h > 0 {
            self.target_buf_w = w;
            self.target_buf_h = h;
        }
    }

    pub fn reset_undersized_nudge(&mut self) {
        self.last_undersized_nudge = None;
    }

    /// OSR buffer should span at least the view in device pixels (≥ ~1× DIP each axis). If not, the compositor
    /// letterbox-upscales and the shell looks blurry while native clients stay sharp.
    pub fn maybe_take_undersized_paint_nudge(
        &mut self,
        buf_w: i32,
        buf_h: i32,
        min_interval: Duration,
    ) -> bool {
        if self.dip_w <= 0 || self.dip_h <= 0 || buf_w <= 0 || buf_h <= 0 {
            return false;
        }
        let tw = self.target_buf_w.max(1);
        let th = self.target_buf_h.max(1);
        if buf_w * 100 >= tw * 97 && buf_h * 100 >= th * 97 {
            return false;
        }
        let now = Instant::now();
        if let Some(t) = self.last_undersized_nudge {
            if now.saturating_duration_since(t) < min_interval {
                return false;
            }
        }
        self.last_undersized_nudge = Some(now);
        true
    }

    pub fn set_buffer_size(&mut self, w: i32, h: i32) {
        if w > 0 && h > 0 {
            self.buffer_w = w;
            self.buffer_h = h;
        }
    }

    pub fn buffer_dimensions(&self) -> (i32, i32) {
        (self.buffer_w, self.buffer_h)
    }

    pub fn device_scale_factor(&self) -> f32 {
        (self.buffer_w as f32 / self.dip_w.max(1) as f32).max(0.01)
    }

    /// Map compositor / frame (**buffer**) coordinates to CEF mouse (**view / DIP**) coordinates.
    pub fn buffer_to_view(&self, bx: i32, by: i32) -> (i32, i32) {
        let bw = self.buffer_w.max(1) as f64;
        let bh = self.buffer_h.max(1) as f64;
        let vx = ((bx as f64) * (self.dip_w as f64) / bw).round() as i32;
        let vy = ((by as f64) * (self.dip_h as f64) / bh).round() as i32;
        let xmax = self.dip_w.saturating_sub(1).max(0);
        let ymax = self.dip_h.saturating_sub(1).max(0);
        (vx.clamp(0, xmax), vy.clamp(0, ymax))
    }

    /// Inverse of [`Self::buffer_to_view`] for shell → compositor geometry.
    pub fn view_to_buffer(&self, vx: i32, vy: i32) -> (i32, i32) {
        let bw = self.buffer_w.max(1) as f64;
        let bh = self.buffer_h.max(1) as f64;
        let dw = self.dip_w.max(1) as f64;
        let dh = self.dip_h.max(1) as f64;
        let bx = ((vx as f64) * bw / dw).round() as i32;
        let by = ((vy as f64) * bh / dh).round() as i32;
        let xmax = self.buffer_w.saturating_sub(1).max(0);
        let ymax = self.buffer_h.saturating_sub(1).max(0);
        (bx.clamp(0, xmax), by.clamp(0, ymax))
    }

    /// Inclusive view rect → buffer rect (matches compositor corner mapping for window sizes).
    pub fn view_rect_to_buffer_rect(&self, vx: i32, vy: i32, vw: i32, vh: i32) -> (i32, i32, i32, i32) {
        let vw = vw.max(1);
        let vh = vh.max(1);
        let (bx0, by0) = self.view_to_buffer(vx, vy);
        let vx1 = vx + vw - 1;
        let vy1 = vy + vh - 1;
        let (bx1, by1) = self.view_to_buffer(vx1, vy1);
        let bww = (bx1 - bx0 + 1).max(1);
        let bhh = (by1 - by0 + 1).max(1);
        (bx0, by0, bww, bhh)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::OsrViewState;

    #[test]
    fn device_scale_tracks_buffer_over_dip() {
        let mut s = OsrViewState::new(800, 600);
        s.set_buffer_size(1200, 900);
        assert!((s.device_scale_factor() - 1.5).abs() < 0.001);
    }

    #[test]
    fn buffer_to_view_scales_linearly() {
        let mut s = OsrViewState::new(800, 600);
        s.set_buffer_size(1200, 900);
        let (vx, vy) = s.buffer_to_view(600, 450);
        assert_eq!((vx, vy), (400, 300));
    }

    #[test]
    fn buffer_center_maps_to_view_center() {
        let mut s = OsrViewState::new(801, 601);
        s.set_buffer_size(801, 601);
        let (vx, vy) = s.buffer_to_view(400, 300);
        assert_eq!((vx, vy), (400, 300));
    }

    #[test]
    fn undersized_nudge_fires_once_then_rate_limits() {
        let mut s = OsrViewState::new(2880, 1920);
        let min = Duration::from_millis(100);
        assert!(s.maybe_take_undersized_paint_nudge(800, 600, min));
        assert!(!s.maybe_take_undersized_paint_nudge(800, 600, min));
        assert!(!s.maybe_take_undersized_paint_nudge(2880, 1920, min));
    }

    #[test]
    fn undersized_uses_target_buffer_not_dip() {
        let mut s = OsrViewState::new(800, 600);
        s.set_target_buffer(1600, 1200);
        let min = Duration::from_millis(100);
        assert!(s.maybe_take_undersized_paint_nudge(800, 600, min));
        assert!(!s.maybe_take_undersized_paint_nudge(1600, 1200, min));
    }
}
